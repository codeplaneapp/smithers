import type React from "react";
import type { SmithersErrorCode } from "@smthrs/errors/SmithersErrorCode";
import type { SmithersError } from "@smthrs/errors/SmithersError";

export type TryCatchFinallyProps = {
  id?: string;
  try: React.ReactElement;
  catch?: React.ReactElement | ((error: SmithersError) => React.ReactElement);
  catchErrors?: SmithersErrorCode[];
  finally?: React.ReactElement;
  skipIf?: boolean;
};
