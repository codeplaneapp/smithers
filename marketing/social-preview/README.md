# GitHub social preview card

`card.png` (1280x640) is the social preview for github.com/smithersai/smithers. Link
unfurls on X, Slack, and Discord use it.

GitHub has no API for this; upload it by hand: repo Settings > General > Social preview >
Edit > Upload an image, and pick `card.png`.

To regenerate after editing `card.html`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --screenshot=card.png --window-size=1280,640 --hide-scrollbars "file://$PWD/card.html"
```
