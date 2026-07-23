import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../stories/**/*.stories.tsx"],
  addons: [],
  core: {
    disableTelemetry: true,
  },
};

export default config;
