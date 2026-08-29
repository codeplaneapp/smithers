export function startPoller(poll: () => void): () => void {
  const timer = setInterval(poll, 1000);
  return () => clearInterval(timer);
}
