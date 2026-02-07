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
    views: {},
    copy: {
      "views/main/index.html": "views/main/index.html",
      "views/main/main.css": "views/main/main.css",
      "views/main/app.css": "views/main/app.css",
      "views/main/main.js": "views/main/main.js",
    },
    mac: {
      bundleCEF: true,
    },
  },
};
