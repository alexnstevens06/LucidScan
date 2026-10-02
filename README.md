# LucidScan

Local content-detection extension from TIDALHack 25. The Chrome-side script sends selected text, or an image or video URL, to a Flask server in this repo. The server scores text with one model and images or video with another.

## Layout

- `chrome_plugin/background.js` creates context-menu items for a text selection, an image, and a video. A click opens `popup.html` and POSTs JSON to `http://localhost:5000/detect`.
- `expectations.txt` (and the copy under `chrome_plugin/`) describes that JSON. `type` is `text`, `image`, or `video`. `content` is the selected text, or the media URL.
- `server.py` loads the text model and the image models, then returns JSON with a `confidence` field from `/detect`.
- `text_detection.py` defines `DesklibAIDetectionModel` and loads `desklib/ai-text-detector-v1.01` on CPU. `predict_single_text` scores one string.
- `detect.py` loads CLIP (`openai/clip-vit-large-patch14`) and ViT (`google/vit-large-patch32-224-in21k`). It defines noise, edge, Fourier-magnitude, EXIF, color-histogram, and invisible-watermark checks, and `process_image` / `process_video` call `classify_image`. Video reads about one frame per second.
- `requirements.txt` and `pyproject.toml` list Python dependencies. `chrome_plugin/` has no `manifest.json`.

## Running

`server.py` calls `app.run(port=5000, debug=True)` when executed as a script.

`detect.py` accepts `--image`, `--video`, or `--gui`. With no flag it prints: use `--image`, `--video`, or `--gui`. `--gui` opens a Gradio page.

`text_detection.py` scores two example strings when executed as a script.
