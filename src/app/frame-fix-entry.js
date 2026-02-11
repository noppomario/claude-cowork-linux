// Load frame fix first
require('./frame-fix-wrapper.js');
// Then load patched main (index.js has yukonSilver patches)
require('./.vite/build/index.js');
