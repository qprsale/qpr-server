'use strict';
/* Online test server for Question Paper Randomizer - company server mode ("Anywhere").
   Also serves app updates (/updates/) and pushed question data (/data/) from the public/ folder.
   Run:  node server.js
   Settings (environment variables):
     PORT        port to listen on (default 8080)
     ADMIN_KEY   secret the Randomizer uses to open sessions and collect answers (at least 12 characters, required)
     DATA_DIR    folder for the test sessions (default ./data)
     PUBLIC_DIR  folder served at /updates/ and /data/ (default ./public)
     HOST        address to listen on (default 0.0.0.0)
   Put it behind HTTPS: candidates' answers and downloads must travel encrypted. */
const path = require('path');
const { startServer } = require('./exam-engine');
const adminKey = process.env.ADMIN_KEY || '';
if (adminKey.length < 12) { console.error('Set ADMIN_KEY (at least 12 characters) before starting, for example:  ADMIN_KEY=choose-a-long-secret node server.js'); process.exit(1); }
startServer({ port: Number(process.env.PORT) || 8080, host: process.env.HOST || '0.0.0.0', adminKey,
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, 'public'),
  pagePath: path.join(__dirname, 'test-page.html'),
  log: m => console.log(new Date().toISOString(), m) })
  .then(({ port }) => console.log(`Online test server running on port ${port}. Candidates open this server's address in a browser. Updates served from /updates/ and /data/.`))
  .catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
