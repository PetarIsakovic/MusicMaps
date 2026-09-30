# Video folder

Drag or copy MP4 files into this folder using Finder. Subfolders work too.

Click the website's search field to see every video, type to filter the list,
and select a result to start playback with its original audio.

To supply an instant thumbnail, place a JPEG beside the video named exactly
like the video plus `.jpg`, for example `My video.mp4.jpg`. Otherwise, the
browser generates a thumbnail. Replacing the JPEG refreshes its cache version.

While `npm run dev` is running, reopening search picks up new, renamed, or
removed files without restarting playback or the server. Wait until a large
file has finished copying before playing it.

For the production site, run `npm run build` after changing this folder. The
build includes these videos and their catalog. Files opened through the browser's
upload button remain separate local files and are not copied into this folder.
