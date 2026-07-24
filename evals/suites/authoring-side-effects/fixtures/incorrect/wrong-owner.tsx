async function notifyOps() {
  return telegram.sendMessage("ops", "done");
}

<Task id="marked" sideEffect computeFn={notifyOps} />;
<Task id="unmarked" computeFn={notifyOps} />;
