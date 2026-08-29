export function checkoutErrorMessage(code: string): string {
  switch (code) {
    case "PAYMENT_DECLINED":
      return "Payment was declined.";
    case "OUT_OF_STOCK":
      return "An item is no longer available.";
    default:
      return `Checkout failed (${code}).`;
  }
}
