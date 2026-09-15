# AgriSummarize — AGR-27

A frontend-only hackathon prototype for source-grounded agricultural extension PDF summarization.

## Files

- `index.html` — application shell, sections, modal and dashboard markup.
- `styles.css` — responsive agriculture + AI visual system.
- `app.js` — PDF.js extraction, page-aware chunking, Gemini REST calls, grounded synthesis, Q&A, translation, copy and download.

## Run

No Node/Express backend is required.

1. Put the three files in the same folder.
2. Serve the folder from a local HTTP server. Do not rely on `file://` because browser modules and PDF.js workers are more reliable over HTTP.
3. Examples:
   - VS Code: install Live Server and open `index.html`.
   - Python: `python -m http.server 5500`
4. Open `http://localhost:5500`.
5. Click **API Settings**, paste a Gemini API key, and save.
6. Upload any text-based agricultural PDF and click **Analyze document**.

If uploading or **API Settings** seem dead, look at the bottom of the page: a red banner now reports the reason. The two usual causes are opening the page over `file://` (browsers block JavaScript modules there, so `app.js` never runs) or a browser that blocks site storage. Serving over HTTP fixes the first; the app still works with blocked storage, it just cannot remember the key between reloads.

## AI setup

The app calls the Gemini REST `generateContent` endpoint directly from the browser using the `x-goog-api-key` header. The default model is `gemini-3.6-flash`; it can be changed in API Settings if your account supports another model.

The key is stored in `localStorage` only for convenience. It is not written into the source files.

## How the real workflow works

1. PDF.js loads the selected PDF in the browser.
2. Every PDF page is read and its extracted text is tagged with its page number.
3. Pages are grouped into chunks when the document is large.
4. Each chunk is sent to the model with a strict source-only extraction instruction.
5. The evidence blocks are synthesized into a final JSON summary.
6. The dashboard renders only fields returned from the document-grounded model response.
7. Q&A uses keyword-based page retrieval from the actual uploaded text, then asks the model to answer only from those selected pages.
8. Translation translates the generated summary while preserving source facts and page references.

## Error cases handled

- no PDF selected
- non-PDF file (also rejected when the browser reports no MIME type but the name ends in `.pdf` — a real PDF is still accepted when the OS sends an empty type)
- empty/scanned PDF with no extractable text
- missing API key
- AI/API failure
- malformed AI structured response
- browser storage blocked (settings work for the session and say so, instead of the whole page failing to start)
- every step of the upload/settings wiring is attached independently, so a single missing element cannot disable the other controls

## Testing

### PDF upload
Upload two different agricultural PDFs. The page count, extracted character count, evidence-block count, main topic and summary should change with the documents.

### AI summary
Use a document containing concrete values such as a fertilizer dose or soil pH. Confirm the value appears only when it exists in the PDF and carries a page reference.

### Q&A
Ask a question whose answer exists in the PDF, then ask for a fact that is absent. The latter should return: `Not specified in the uploaded document.`

### Translation
After analysis, choose Tamil/Hindi/etc. and click **Translate complete summary**. The entire generated summary is translated; numbers and page references are instructed to remain unchanged.

## Frontend-only limitations

1. A browser-visible API key cannot be considered secret. This is suitable for a hackathon prototype, not a public production service. For production, put the model call behind a backend/serverless proxy or use provider-supported browser-safe authentication.
2. PDF.js extracts selectable text. Image-only/scanned PDFs need OCR, which is not included in this build.
3. Very large documents are chunked, but the final synthesis is based on compressed evidence blocks. Extremely large documents can still hit model quota/context limits.
4. Q&A uses lightweight keyword retrieval in the browser. A production RAG system would use embeddings/vector retrieval for stronger semantic retrieval.
5. The privacy statement is intentionally precise: the PDF itself is read locally, but extracted text is sent to Gemini when AI analysis or Q&A/translation is requested.
