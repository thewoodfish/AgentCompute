'use strict';
// Vercel serverless entry — loads the pre-built Express app
const m = require('../dist/server.js');
module.exports = m.default || m;
