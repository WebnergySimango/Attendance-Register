// Local-only entry point. Vercel never runs this file — it calls api/index.js
// directly as a serverless function. This file exists purely so you (or I) can
// run `node local-dev.js` and test against a real database on a laptop or in
// this sandbox before pushing to Vercel.
require('dotenv').config();
const app = require('./api/index.js');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Local dev server running on port ${PORT}`));
