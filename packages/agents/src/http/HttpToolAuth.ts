export type HttpToolAuth =
  | {
      type: "bearer";
      token: string;
    }
  | {
      type: "basic";
      username: string;
      password: string;
    }
  | {
      type: "header";
      name: string;
      value: string;
    };
