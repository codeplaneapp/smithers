async function publishUpdate() {
  return slack.chat.postMessage({ text: "done" });
}

<Task id="marked" sideEffect computeFn={publishUpdate} />;
<Task id="unmarked" computeFn={publishUpdate} />;
