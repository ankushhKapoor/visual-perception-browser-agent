const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

/** @type {import('webpack').Configuration} */
module.exports = {
  entry: {
    background: "./src/background.ts",
    content: "./src/content.ts",
    popup: "./src/popup.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        // Copy manifest and popup HTML
        { from: "public", to: "." },
        // Copy icon placeholders if they exist
        { from: "public/icons", to: "icons", noErrorOnMissing: true },
      ],
    }),
  ],
  // Content scripts & service workers don't use import() — keep bundles flat
  optimization: {
    splitChunks: false,
  },
};
