// Webpack config for the Docker Manager SPA.
//
// Output layout (under dist/):
//   index.html                                  served at /
//   app.<contenthash>.js                        served at /assets/app.<hash>.js
//   app.<contenthash>.css                       served at /assets/app.<hash>.css
//
// The backend mounts /assets -> staticDir, so publicPath: '/assets/' makes
// the script/link tags HtmlWebpackPlugin injects resolve correctly.
const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = (_env, argv) => {
  const isProd = argv.mode === 'production';
  return {
    entry: './src/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      publicPath: '/assets/',
      filename: isProd ? '[name].[contenthash].js' : '[name].js',
      chunkFilename: isProd ? '[name].[contenthash].chunk.js' : '[name].chunk.js',
      assetModuleFilename: isProd ? '[name].[contenthash][ext]' : '[name][ext]',
      clean: true,
    },
    devtool: isProd ? 'source-map' : 'eval-cheap-module-source-map',
    target: ['web', 'es2020'],
    module: {
      rules: [
        {
          test: /\.css$/i,
          use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'],
        },
        {
          // Bitmap / font assets that any of our deps might import.
          test: /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|eot)$/i,
          type: 'asset/resource',
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: 'src/index.html',
        inject: 'body',
        scriptLoading: 'defer',
        minify: isProd,
      }),
      new MiniCssExtractPlugin({
        filename: isProd ? '[name].[contenthash].css' : '[name].css',
      }),
    ],
    optimization: {
      minimize: isProd,
    },
    performance: { hints: false },
    stats: { preset: 'errors-warnings', colors: false },
  };
};
