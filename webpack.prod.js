const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const { InjectManifest } = require("workbox-webpack-plugin");

module.exports = merge(common, {
  mode: 'production',
  plugins: [
    new InjectManifest({
      swSrc: "./src/sw.ts"
    })
  ]
});
