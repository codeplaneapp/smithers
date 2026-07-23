import type { Decorator, Preview } from "@storybook/react-vite";
import { SmithersUiStyles, tokens } from "@smithers-orchestrator/ui";

const withSmithersTheme: Decorator = (Story, context) => {
  const theme = String(context.globals.theme ?? "light");
  document.documentElement.dataset.theme = theme;
  return (
    <div
      style={{
        background: tokens.background,
        color: tokens.foreground,
        minHeight: "100vh",
        padding: "1.5rem",
      }}
    >
      <SmithersUiStyles withTheme />
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withSmithersTheme],
  globalTypes: {
    theme: {
      description: "Smithers UI theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default preview;
