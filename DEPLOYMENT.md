# Deploy MusicMaps to Netlify

## Import the repository

1. Sign in to [Netlify](https://app.netlify.com/).
2. Choose **Add new project → Import an existing project → GitHub**.
3. Authorize access to **PetarIsakovic/MusicMaps** and select it.
4. Use branch `main`, leave the base directory empty, use `npm run build` as the build command, and `dist` as the publish directory. `netlify.toml` supplies these build settings and Node 22.
5. Before deploying, add these environment variables with the **Builds** scope and apply them to all deploy contexts:

   | Variable | Value |
   | --- | --- |
   | `GIT_LFS_ENABLED` | `true` |
   | `GIT_LFS_FETCH_INCLUDE` | `*.mp4,*.jpg` |

   Set these in Netlify's UI, not just `netlify.toml`. Netlify needs them before it checks out the repository. If the import screen does not offer variables, stop the first deploy, add them under project configuration, and trigger a fresh deploy with the build cache cleared.
6. Select **Deploy**. The first checkout includes approximately 1.9 GB of media and imagery, so allow time for the assets to download.
7. Open the resulting HTTPS `netlify.app` URL and share it. A custom domain is optional.

## Check the deployed site

- Open search and confirm all six demo videos and thumbnails appear.
- Select a demo and check playback, seeking, audio, and the satellite reconstruction.
- Upload a local video. It should play automatically; the selected file stays in that visitor's browser.
- Click a satellite cell and open its location. Both the preview and map should load.

If thumbnails or videos contain text starting with `version https://git-lfs.github.com/spec/v1`, Git LFS files were not downloaded. Check the two variables and redeploy with a cleared build cache. The build also detects unresolved LFS pointers and stops with a useful error.

## Publish later changes

```sh
git add .
git commit -m "Describe the change"
git push
```

Netlify rebuilds the site after pushes to `main`. Add future demo MP4s to `public/videos`, with a thumbnail named `Video name.mp4.jpg`. Commit both. Personal uploads through the website are not added to the shared library.

The video library and atlas files use GitHub LFS; the other imagery is checked into Git. Each fresh LFS checkout consumes GitHub LFS download bandwidth. Site visitors receive deployed files from Netlify. Monitor usage in both accounts as traffic grows.

Satellite imagery retains its EOX/Copernicus attribution and CC BY-NC-SA 4.0 terms, documented in the README. This is an independent project, not an official Google Maps service.

## References

- [Netlify Vite setup](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
- [Netlify Git LFS environment variables](https://docs.netlify.com/build/configure-builds/environment-variables/)
- [GitHub LFS storage and bandwidth](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)
