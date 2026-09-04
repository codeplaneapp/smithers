export type VisibilityListener = () => void;

export type VisibilityListeners = Map<string, Set<VisibilityListener>>;

export function subscribeVisibility(
  visibilityListeners: VisibilityListeners,
  messageId: string,
  listener: VisibilityListener,
): () => void {
  let listeners = visibilityListeners.get(messageId);
  if (!listeners) {
    listeners = new Set();
    visibilityListeners.set(messageId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && visibilityListeners.get(messageId) === listeners) {
      visibilityListeners.delete(messageId);
    }
  };
}
