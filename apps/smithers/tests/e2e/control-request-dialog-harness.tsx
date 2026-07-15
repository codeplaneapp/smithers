import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import "../../src/control/control.css";
import { ControlRing } from "../../src/control/ControlRing";
import { ControlRequestDialog } from "../../src/control/ControlRequestDialog";
import { useControlStore } from "../../src/control/controlStore";

const reason = "Switch the theme for this review.";

function ControlRequestDialogHarness() {
  const processReply = useControlStore((state) => state.processReply);
  const releaseControl = useControlStore((state) => state.releaseControl);

  function requestControl() {
    releaseControl();
    processReply([
      { tool: "requestControl", reason },
      { tool: "setTheme", args: { theme: "dark" } },
    ]);
  }

  return (
    <main>
      <button type="button" onClick={requestControl}>
        Request control
      </button>
      <ControlRing />
      <ControlRequestDialog />
    </main>
  );
}

useControlStore.setState({ controller: "user", pendingControl: null });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ControlRequestDialogHarness />
  </StrictMode>,
);
