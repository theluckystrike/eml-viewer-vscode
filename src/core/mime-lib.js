'use strict';
// One place that loads postal-mime (MIT-0), so the bundle and the tests use the same copy.
const PostalMime = require('postal-mime');
const PM = PostalMime.default || PostalMime;
module.exports = { PostalMime: PM, decodeWords: PM.decodeWords, addressParser: PM.addressParser };
