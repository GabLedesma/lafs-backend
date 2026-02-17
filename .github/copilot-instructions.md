# Copilot Instructions for AI Coding Agents

## Project Overview
This is a Firebase Cloud Functions backend project. The main logic resides in the `functions/` directory, with entry point at `functions/index.js`. The project is managed via Node.js and Firebase tooling.

## Architecture & Data Flow
- **Entry Point:** All backend logic starts from `functions/index.js`.
- **Service Boundaries:** Functions are deployed as serverless endpoints via Firebase Functions. Each exported function in `index.js` is a separate endpoint.
- **External Integration:** Uses Firebase for deployment and hosting. Node.js packages are managed in `functions/package.json`.

## Developer Workflows
- **Install Dependencies:**
  ```powershell
  cd functions; npm install
  ```
- **Local Emulation:**
  ```powershell
  firebase emulators:start
  ```
- **Deploy to Firebase:**
  ```powershell
  firebase deploy --only functions
  ```
- **Debugging:**
  Use `console.log` in function code. Logs are viewable in Firebase Console or local emulator output.

## Project-Specific Conventions
- All Cloud Functions are defined and exported in `functions/index.js`.
- Shared code should be placed in separate modules within `functions/` and imported into `index.js`.
- Environment variables and secrets are managed via Firebase config (`firebase functions:config:set`).
- Avoid hardcoding secrets or config values in code.

## Integration Points
- **Firebase:** Project configuration in `firebase.json`.
- **Node.js:** Dependencies in `functions/package.json`.
- **Cloud Functions:** Main logic in `functions/index.js`.

## Example Pattern
```js
// functions/index.js
const functions = require('firebase-functions');

exports.helloWorld = functions.https.onRequest((request, response) => {
  response.send("Hello from Firebase!");
});
```

## Key Files & Directories
- `functions/index.js`: Main function definitions
- `functions/package.json`: Node.js dependencies
- `firebase.json`: Firebase project configuration

---

**For AI agents:**
- Always check `functions/index.js` for entry points and exported functions.
- Use the provided workflows for install, emulation, and deployment.
- Follow the conventions for code organization and secrets management.
- Reference the example pattern for new function definitions.
