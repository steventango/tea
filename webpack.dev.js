const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require("path");

module.exports = merge(common, {
  mode: 'development',
  devtool: 'inline-source-map',
  devServer: {
    compress: true,
    host: "0.0.0.0",
    port: 8080,
    open: false,
    static: path.join(__dirname, "dist"),
  }
});
