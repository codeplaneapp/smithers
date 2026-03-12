import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Mr. Burns",
    identifier: "ai.mrburns.desktop",
    version: "0.1.0",
    description: "Mr. Burns desktop shell",
  },
  build: {
    bun: {
      entrypoint: "./src/index.ts",
    },
    copy: {
      "../web/dist": "views/mainview",
    },
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      icons: "../../assets/icons/macos.iconset",
    },
    win: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "../../assets/icons/app-icon.png",
    },
    linux: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "../../assets/icons/app-icon.png",
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  scripts: {
    preBuild: "./scripts/prebuild-web.ts",
    postBuild: "./scripts/copy-web-assets.ts",
  },
} satisfies ElectrobunConfig
