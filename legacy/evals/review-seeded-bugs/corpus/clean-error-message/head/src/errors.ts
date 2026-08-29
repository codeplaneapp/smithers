export function checkoutErrorMessage(code: string): string {
  switch (code) {
    case "PAYMENT_DECLINED":
      return "The payment method was declined.";
    case "OUT_OF_STOCK":
      return "An item in the cart is no longer available.";
    default:
      return `Checkout could not be completed (${code}).`;
  }
}
