/** Up to 169 parent cells per edge plus padding; picking also identifies each child. */
export const CELL_STRIDE = 192;
export const MAX_DENSITY = 260;
export const BASE_DENSITY_SCALE = 0.65;
/** Five image choices plus one data texel describing the moving cell geometry. */
export const STATE_SLOTS = 6;

export const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
varying vec2 v_uv;
uniform vec2 u_resolution;
uniform vec2 u_sourceSize;
uniform float u_density;
uniform float u_organic;
uniform vec2 u_stateSize;
vec2 hash2(vec2 p) {
#ifdef LIMITED_PRECISION
  // Keep every intermediate bounded on GPUs with 16-bit fragment floats.
  // A large sine multiplier would erase its fractional bits on those devices.
  p = mod(p, vec2(71.0, 67.0));
  return fract(sin(vec2(dot(p, vec2(0.1271, 0.3117)), dot(p, vec2(0.2695, 0.1833)))) * 127.1);
#else
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
#endif
}
vec2 gridSize() { return u_resolution / max(u_resolution.x, u_resolution.y) * u_density * 0.65; }
vec2 cellCenter(vec2 cell) { return cell + 0.5 + (hash2(cell) - 0.5) * mix(0.24, 0.87, u_organic); }
vec2 childOffset(float child) {
  return (vec2(mod(child, 2.0), floor(child / 2.0)) - 0.5) * 0.48;
}
vec2 stateUV(vec2 cell, float slot) {
  return (vec2((cell.x + 1.0) * 6.0 + slot, cell.y + 1.0) + 0.5) / (u_stateSize * vec2(6.0, 1.0));
}
vec2 movingCenter(vec2 cell, vec4 geometry) {
  return cellCenter(cell) + (geometry.rg * 255.0 - 128.0) / 127.0 * 0.18;
}
vec2 cellShape(vec4 geometry) { return (geometry.ba * 255.0 - 128.0) / 127.0; }
// Guide child placement along an edge. Photo matching and photograph pixels
// keep their upright orientation, independent of the shape deformation.
vec2 shapeOffset(vec2 offset, vec2 shape) {
  float amount = length(shape);
  vec2 normal = shape / max(amount, 0.0001);
  return offset - normal * dot(offset, normal) * amount * 0.32;
}
vec2 sourceUV(vec2 uv) {
  float screenAspect = u_resolution.x / u_resolution.y;
  float sourceAspect = u_sourceSize.x / u_sourceSize.y;
  if (screenAspect > sourceAspect) uv.y = (uv.y - 0.5) * sourceAspect / screenAspect + 0.5;
  else uv.x = (uv.x - 0.5) * screenAspect / sourceAspect + 0.5;
  return clamp(uv, 0.0, 1.0);
}
`;

/** One fragment per parent/child, not per displayed pixel. Output is image IDs only. */
export const MATCH_SHADER = COMMON + `
uniform sampler2D u_video;
uniform sampler2D u_lookup;
uniform sampler2D u_features;
uniform sampler2D u_previous;
uniform vec2 u_featureGrid;
uniform float u_lookupSize;
uniform float u_lookupVariants;
uniform float u_contrast;
uniform float u_hasVideo;
uniform float u_history;
uniform float u_patchCount;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec4 feature(vec2 encoded, float part) {
  float row = floor(encoded.r / u_featureGrid.x) + encoded.g * (256.0 / u_featureGrid.x);
  vec2 uv = (vec2(mod(encoded.r, u_featureGrid.x) * 2.0 + part, row) + 0.5) / (u_featureGrid * vec2(2.0, 1.0));
  return texture2D(u_features, uv);
}
vec4 geometryFor(vec2 cell) {
  if (u_hasVideo < 0.5) return vec4(128.0 / 255.0);
  vec2 center = cellCenter(cell);
  vec2 grid = gridSize();
  vec3 middle = texture2D(u_video, sourceUV(center / grid)).rgb;
  vec3 left = texture2D(u_video, sourceUV((center + vec2(-0.38, 0.0)) / grid)).rgb;
  vec3 right = texture2D(u_video, sourceUV((center + vec2(0.38, 0.0)) / grid)).rgb;
  vec3 bottom = texture2D(u_video, sourceUV((center + vec2(0.0, -0.38)) / grid)).rgb;
  vec3 top = texture2D(u_video, sourceUV((center + vec2(0.0, 0.38)) / grid)).rgb;
  vec3 dx = right - left;
  vec3 dy = top - bottom;
  // The RGB structure tensor catches colored edges as well as luminance edges.
  float xx = dot(dx, dx), yy = dot(dy, dy), xy = dot(dx, dy);
  float strength = smoothstep(0.055, 0.75, max(xx, yy));
  float angle = 0.5 * atan(2.0 * xy, xx - yy + 0.00001);
  vec2 shape = vec2(cos(angle), sin(angle)) * strength;
  vec3 dl = left - middle, dr = right - middle, db = bottom - middle, dt = top - middle;
  vec4 similarity = 1.0 / (1.0 + vec4(dot(dl, dl), dot(dr, dr), dot(db, db), dot(dt, dt)) * 24.0);
  vec2 shift = vec2(similarity.y - similarity.x, similarity.w - similarity.z) * strength;
  // Bound the centers so adjacent cells continue to cover the canvas cleanly.
  shift = (clamp(center + shift * 0.18, cell + 0.10, cell + 0.90) - center) / 0.18;
  vec4 proposed = vec4(shift, shape);
  if (u_history > 0.5) {
    vec4 old = (texture2D(u_previous, stateUV(cell, 5.0)) * 255.0 - 128.0) / 127.0;
    // A dead band suppresses tiny boundary tremors; meaningful changes use the
    // current frame immediately, without an animation timer or motion lag.
    if (length(proposed.rg - old.rg) < 0.07) proposed.rg = old.rg;
    if (length(proposed.ba - old.ba) < 0.07) proposed.ba = old.ba;
  }
  return floor(clamp(proposed * 127.0 + 128.0, 0.0, 255.0) + 0.5) / 255.0;
}
void sampleRegion(vec2 center, float scale, out vec3 mean, out vec4 quadrants, out float edge) {
  vec2 step = vec2(0.24 * scale) / gridSize();
  vec2 uv = center / gridSize();
  vec3 tl = texture2D(u_video, sourceUV(uv + vec2(-step.x, step.y))).rgb;
  vec3 tr = texture2D(u_video, sourceUV(uv + step)).rgb;
  vec3 bl = texture2D(u_video, sourceUV(uv - step)).rgb;
  vec3 br = texture2D(u_video, sourceUV(uv + vec2(step.x, -step.y))).rgb;
  vec3 middle = texture2D(u_video, sourceUV(uv)).rgb;
  mean = (tl + tr + bl + br) * 0.2 + middle * 0.2;
  quadrants = vec4(dot(tl, LUMA), dot(tr, LUMA), dot(bl, LUMA), dot(br, LUMA));
  vec3 range = max(max(tl, tr), max(max(bl, br), middle)) - min(min(tl, tr), min(min(bl, br), middle));
  edge = max(max(range.r, range.g), range.b);
  mean = clamp((mean - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  quadrants = clamp((quadrants - 0.5) * u_contrast + 0.5, 0.0, 1.0);
}
float score(vec2 encoded, vec3 target, vec4 pattern) {
  vec4 description = feature(encoded, 0.0);
  vec3 delta = description.rgb - target;
  vec4 shape = feature(encoded, 1.0) - dot(description.rgb, LUMA);
  vec4 difference = shape - pattern;
  return dot(delta * delta, vec3(0.30, 0.59, 0.11)) * 4.0 + dot(difference, difference) * 0.20;
}
void main() {
  vec2 pixel = floor(gl_FragCoord.xy);
  float slot = mod(pixel.x, 6.0);
  vec2 cell = vec2(floor(pixel.x / 6.0), pixel.y) - 1.0;
  vec4 geometry = geometryFor(cell);
  if (slot > 4.5) { gl_FragColor = geometry; return; }
  vec2 center = movingCenter(cell, geometry);
  vec2 shape = cellShape(geometry);
  vec3 target;
  vec4 quadrants;
  float edge;
  sampleRegion(center, 1.0, target, quadrants, edge);
  vec4 oldParent = texture2D(u_previous, stateUV(cell, 0.0));
  // Different enter/leave thresholds avoid repeatedly splitting a weak edge.
  float splitThreshold = u_history > 0.5 && oldParent.b > 0.5 ? 0.105 : 0.16;
  float split = edge > splitThreshold && u_hasVideo > 0.5 ? 1.0 : 0.0;
  if (slot > 0.5) sampleRegion(center + shapeOffset(childOffset(slot - 1.0), shape), 0.5, target, quadrants, edge);
  if (u_hasVideo < 0.5) {
    vec2 random = hash2(cell + 17.3);
    float id = floor(fract(random.x * 7.13 + random.y * 3.71) * u_patchCount);
    vec2 encoded = vec2(mod(id, 256.0), floor(id / 256.0));
    target = feature(encoded, 0.0).rgb;
    quadrants = feature(encoded, 1.0);
  }
  vec4 pattern = quadrants - dot(target, LUMA);
  vec3 bin = floor(target * (u_lookupSize - 1.0) + 0.5);
  vec2 best = vec2(0.0);
  float bestError = 1000.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_lookupVariants) break;
    vec2 uv = (vec2(bin.r + bin.b * u_lookupSize, bin.g + float(i) * u_lookupSize) + 0.5)
      / vec2(u_lookupSize * u_lookupSize, u_lookupSize * u_lookupVariants);
    vec2 candidate = floor(texture2D(u_lookup, uv).rg * 255.0 + 0.5);
    float error = score(candidate, target, pattern);
    // Stable tie breaking gives similar regions some photographic variety.
    error += hash2(cell + vec2(slot * 13.0, float(i) * 7.0)).x * 0.000025;
    if (error < bestError) { bestError = error; best = candidate; }
  }
  vec4 old = texture2D(u_previous, stateUV(cell, slot));
  if (u_history > 0.5 && old.a > 0.5) {
    vec2 candidate = floor(old.rg * 255.0 + 0.5);
    float oldError = score(candidate, target, pattern);
    // Keep a still-good photo through small fluctuations. A materially better
    // current-frame match replaces it immediately; no image blending or delay.
    if (oldError <= bestError + 0.00065 + bestError * 0.04) best = candidate;
  }
  gl_FragColor = vec4(best / 255.0, split, 1.0);
}`;

export const DISPLAY_SHADER = COMMON + `
uniform sampler2D u_atlas;
uniform sampler2D u_atlasSecond;
uniform sampler2D u_atlasThird;
uniform sampler2D u_atlasFourth;
uniform sampler2D u_cells;
uniform sampler2D u_photoBounds;
uniform sampler2D u_detailAtlas;
uniform sampler2D u_video;
uniform vec2 u_atlasGrid;
uniform vec4 u_atlasRows;
uniform vec4 u_tileInset;
uniform vec3 u_view;
uniform float u_hasVideo;
uniform vec2 u_detailPatch;
uniform float u_pickMode;
uniform vec2 u_pickUV;
uniform vec3 u_pickCell;
uniform float u_pickSub;
uniform vec4 u_selection;
void considerCell(vec2 neighbor, vec2 point, inout float closest, inout float second,
                  inout vec2 cell, inout vec2 center, inout vec2 shape) {
  if (any(lessThan(neighbor, vec2(-1.0))) || any(greaterThan(neighbor, u_stateSize - 2.0))) return;
  // An outer neighbor can only win if its entire possible center box is close.
  vec2 lowerBound = max(max(neighbor + 0.06 - point, point - neighbor - 0.94), 0.0);
  if (dot(lowerBound, lowerBound) > second) return;
  vec4 geometry = texture2D(u_cells, stateUV(neighbor, 5.0));
  vec2 position = movingCenter(neighbor, geometry);
  vec2 candidateShape = cellShape(geometry);
  vec2 delta = position - point;
  float d = dot(delta, delta);
  if (d < closest) {
    second = closest; closest = d; cell = neighbor; center = position; shape = candidateShape;
  } else second = min(second, d);
}
void main() {
  float longest = max(u_resolution.x, u_resolution.y);
  vec2 screenUV = u_pickMode > 0.5 ? u_pickUV : v_uv;
  vec2 worldUV = (screenUV - 0.5) / u_view.x + 0.5 + u_view.yz;
  vec2 grid = worldUV * gridSize();
  vec2 warp = vec2(sin(grid.y * 2.7 + sin(grid.x * 1.3)), cos(grid.x * 2.2 + sin(grid.y * 1.8)));
  vec2 organicGrid = grid + warp * u_organic * 0.20;
  vec2 base = floor(organicGrid);
  float closest = 100.0;
  float second = 100.0;
  vec2 cell = vec2(0.0);
  vec2 center = vec2(0.0);
  vec2 shape = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      considerCell(base + vec2(float(x), float(y)), organicGrid, closest, second, cell, center, shape);
    }
  }
  // Moving cells can reach past the immediate nine neighbors.
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == -2 || x == 2 || y == -2 || y == 2)
        considerCell(base + vec2(float(x), float(y)), organicGrid, closest, second, cell, center, shape);
    }
  }
  if (u_pickCell.z > 0.5) {
    cell = u_pickCell.xy;
    vec4 geometry = texture2D(u_cells, stateUV(cell, 5.0));
    center = movingCenter(cell, geometry); shape = cellShape(geometry);
  }
  float boundary = sqrt(second) - sqrt(closest);
  vec4 chosen = texture2D(u_cells, stateUV(cell, 0.0));
  vec2 parentCenter = center;
  float child = -1.0;
  if (chosen.b > 0.5) {
    float nearestChild = 100.0;
    float nextChild = 100.0;
    vec2 childCenter = center;
    for (int i = 0; i < 4; i++) {
      vec2 position = center + shapeOffset(childOffset(float(i)), shape);
      vec2 delta = organicGrid - position;
      float d = dot(delta, delta);
      if (d < nearestChild) { nextChild = nearestChild; nearestChild = d; child = float(i); childCenter = position; }
      else nextChild = min(nextChild, d);
    }
    if (u_pickCell.z > 0.5) { child = max(0.0, u_pickSub); childCenter = center + shapeOffset(childOffset(child), shape); }
    center = childCenter;
    boundary = min(boundary, sqrt(nextChild) - sqrt(nearestChild));
    chosen = texture2D(u_cells, stateUV(cell, child + 1.0));
  }
  vec2 encoded = floor(chosen.rg * 255.0 + 0.5);
  if (u_pickMode > 0.5) {
    // Split the cell address into bytes before multiplying. All intermediate
    // integers stay below 2048, including on mediump-only WebGL1 devices.
    // The two unused high bits of the image ID's green byte carry address bits.
    float code = child + 1.0;
    vec2 padded = cell + 1.0;
    float low = mod(padded.y, 8.0) * ${CELL_STRIDE.toFixed(1)} + padded.x;
    float high = floor(padded.y / 8.0) * ${(CELL_STRIDE / 32).toFixed(1)} + floor(low / 256.0);
    low = mod(low, 256.0) * 5.0 + code;
    high = high * 5.0 + floor(low / 256.0);
    gl_FragColor = vec4(encoded.r, encoded.g + floor(high / 256.0) * 64.0,
      mod(low, 256.0), mod(high, 256.0)) / 255.0;
    return;
  }
  // Only the clipping mask uses organic coordinates. Use an upright square
  // over its conservative bounds so rivers/roads stay straight and photo
  // edges never turn into stretched strips under CLAMP_TO_EDGE sampling.
  vec4 photoBounds = texture2D(u_photoBounds, stateUV(cell, child + 1.0)) * 4.5 - 2.25;
  vec2 photoCenter = parentCenter + (photoBounds.xy + photoBounds.zw) * 0.5;
  vec2 photoExtent = photoBounds.zw - photoBounds.xy;
  float photoSize = max(max(photoExtent.x, photoExtent.y), 0.01);
  vec2 cellUV = (grid - photoCenter) / photoSize + 0.5;
  float row = floor(encoded.r / u_atlasGrid.x) + encoded.g * (256.0 / u_atlasGrid.x);
  float page = floor(row / u_atlasGrid.y);
  float rows = page < 0.5 ? u_atlasRows.x : page < 1.5 ? u_atlasRows.y : page < 2.5 ? u_atlasRows.z : u_atlasRows.w;
  float inset = page < 0.5 ? u_tileInset.x : page < 1.5 ? u_tileInset.y : page < 2.5 ? u_tileInset.z : u_tileInset.w;
  vec2 tilePosition = vec2(mod(encoded.r, u_atlasGrid.x), rows - 1.0 - mod(row, u_atlasGrid.y));
  vec2 atlasUV = (tilePosition + mix(vec2(inset), vec2(1.0 - inset), cellUV)) / vec2(u_atlasGrid.x, rows);
  vec3 color;
  if (page < 0.5) color = texture2D(u_atlas, atlasUV).rgb;
  else if (page < 1.5) color = texture2D(u_atlasSecond, atlasUV).rgb;
  else if (page < 2.5) color = texture2D(u_atlasThird, atlasUV).rgb;
  else color = texture2D(u_atlasFourth, atlasUV).rgb;
  // Compare byte-sized IDs so adjacent photos stay distinct on mediump GPUs.
  if (u_detailPatch.x >= 0.0 && all(lessThan(abs(encoded - u_detailPatch), vec2(0.5)))) {
    color = texture2D(u_detailAtlas, cellUV).rgb;
  }
  float smoothing = max(u_density * 0.65 / longest / u_view.x * 0.35, 0.003);
  float blob = smoothstep(0.001, smoothing, boundary);
  // Adjacent masks meet directly. Artificial dark seams added grain to bright
  // video and obscured fine silhouettes; retain the actual photo pixels here.
  bool selected = u_selection.w > 0.5 && all(lessThan(abs(cell - u_selection.xy), vec2(0.5)))
    && abs(child - u_selection.z) < 0.5;
  if (selected) {
    float outline = (1.0 - smoothstep(smoothing, smoothing * 3.0, boundary)) * blob;
    color = mix(color, vec3(0.96, 0.98, 1.0), outline * 0.85);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

/** Fit upright photographs once per cell, rather than distorting their pixels. */
export const PHOTO_BOUNDS_SHADER = COMMON + `
uniform sampler2D u_cells;
vec2 polygon[16];
int vertices;
void appendVertex(inout vec2 outputVertices[16], inout int count, vec2 vertex) {
  // GLSL ES 1.00 guarantees array access through constant loop indices, but
  // not a runtime append position on every WebGL1 implementation.
  for (int i = 0; i < 16; i++) {
    if (i == count) outputVertices[i] = vertex;
  }
  count++;
}
void clipPolygon(vec2 normal, float limit) {
  if (vertices < 1) return;
  vec2 result[16];
  int count = 0;
  vec2 previous = polygon[0];
  for (int i = 0; i < 16; i++) {
    if (i == vertices - 1) previous = polygon[i];
  }
  float previousDistance = dot(previous, normal) - limit;
  for (int i = 0; i < 16; i++) {
    if (i >= vertices) break;
    vec2 current = polygon[i];
    float distance = dot(current, normal) - limit;
    if ((distance <= 0.0) != (previousDistance <= 0.0)) {
      float t = previousDistance / (previousDistance - distance);
      appendVertex(result, count, mix(previous, current, t));
    }
    if (distance <= 0.0) appendVertex(result, count, current);
    previous = current;
    previousDistance = distance;
  }
  vertices = count;
  for (int i = 0; i < 16; i++) {
    if (i >= vertices) break;
    polygon[i] = result[i];
  }
}
void main() {
  vec2 pixel = floor(gl_FragCoord.xy);
  float slot = mod(pixel.x, 6.0);
  if (slot > 4.5) { gl_FragColor = vec4(0.0); return; }
  vec2 cell = vec2(floor(pixel.x / 6.0), pixel.y) - 1.0;
  if (slot > 0.5 && texture2D(u_cells, stateUV(cell, 0.0)).b < 0.5) {
    gl_FragColor = vec4(0.0); return;
  }
  vec4 geometry = texture2D(u_cells, stateUV(cell, 5.0));
  vec2 center = movingCenter(cell, geometry);
  vec2 shape = cellShape(geometry);
  polygon[0] = vec2(-2.0, -2.0); polygon[1] = vec2(2.0, -2.0);
  polygon[2] = vec2(2.0, 2.0); polygon[3] = vec2(-2.0, 2.0);
  vertices = 4;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x != 0 || y != 0) {
        vec2 neighbor = cell + vec2(float(x), float(y));
        if (all(greaterThanEqual(neighbor, vec2(-1.0))) && all(lessThanEqual(neighbor, u_stateSize - 2.0))) {
          vec2 delta = movingCenter(neighbor, texture2D(u_cells, stateUV(neighbor, 5.0))) - center;
          clipPolygon(delta, dot(delta, delta) * 0.5);
        }
      }
    }
  }
  if (slot > 0.5) {
    vec2 child = shapeOffset(childOffset(slot - 1.0), shape);
    for (int i = 0; i < 4; i++) {
      if (abs(float(i) - (slot - 1.0)) > 0.5) {
        vec2 sibling = shapeOffset(childOffset(float(i)), shape);
        clipPolygon(sibling - child, (dot(sibling, sibling) - dot(child, child)) * 0.5);
      }
    }
  }
  vec2 lower = vec2(2.0), upper = vec2(-2.0);
  for (int i = 0; i < 16; i++) {
    if (i >= vertices) break;
    lower = min(lower, polygon[i]); upper = max(upper, polygon[i]);
  }
  // Removing the screen warp can move any edge by at most this amount.
  // Round bounds outward so RGBA8 quantization cannot expose a photo edge.
  float margin = u_organic * 0.20 + 0.01;
  lower = floor((lower - margin + 2.25) / 4.5 * 255.0);
  upper = ceil((upper + margin + 2.25) / 4.5 * 255.0);
  gl_FragColor = vec4(lower, upper) / 255.0;
}`;
