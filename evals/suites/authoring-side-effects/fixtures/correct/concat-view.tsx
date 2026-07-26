const command = "gh pr " + "view" + " 42";
<Task id="inspect">{() => exec(command)}</Task>;
