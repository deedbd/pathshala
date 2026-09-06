# PDF fonts

Shipped in the release zip so report cards, receipts and admit cards render Bangla on shared hosting
without Chrome. All files are under the SIL Open Font License (`OFL.txt`).

| File | Source | Used for |
|---|---|---|
| `NotoSansBengali-Regular.ttf`, `NotoSansBengali-Bold.ttf` | notofonts/notofonts.github.io (hinted static) | Bangla + Latin (default PDF font) |
| `IBMPlexSans-Regular.ttf` | google/fonts `ofl/ibmplexsans` (variable) | Latin body text when `fontFamily: 'IBMPlexSans'` is requested |

`PdfmakePdf` picks Noto Sans Bengali as the default when present and falls back to pdfmake's bundled
Roboto (Latin only) when the directory is empty. Override the directory with `FONTS_DIR`.
