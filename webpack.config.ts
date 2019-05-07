import webpack from 'webpack';
import path from 'path';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

export default (env: { mode?: webpack.Configuration['mode'] } = {}): webpack.Configuration => ({
  entry: {
    panel: path.resolve(__dirname, 'src-refactor', 'panel', 'panel.ts'),
    'background-page': path.resolve(__dirname, 'src-refactor', 'background-page', 'background-page.ts'),
  },
  mode: env.mode || 'development',
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json'],
  },
  output: {
    path: path.resolve(__dirname, './lib'),
    filename: '[name].bundle.js',
    publicPath: '/',
  },
  plugins: [new MiniCssExtractPlugin()],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          compilerOptions: {
            module: 'esnext',
          },
        },
      },
      {
        test: /\.css$/,
        loader: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
});
