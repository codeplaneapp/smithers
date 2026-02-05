export default {
  app: {
    name: "Smithers",
    identifier: "com.smithers.desktop",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/webview/main.ts",
      },
    },
    copy: {
      "views/main/index.html": "views/main/index.html",
      "views/main/main.css": "views/main/main.css",
      "views/main/app.css": "views/main/app.css",
    },
    mac: {
      bundleCEF: true,
    },
  },
};
