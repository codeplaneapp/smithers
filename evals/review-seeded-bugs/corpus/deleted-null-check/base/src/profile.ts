export type Profile = { displayName?: string | null };

export function displayName(profile: Profile | null): string {
  if (!profile || !profile.displayName) {
    return "Anonymous";
  }
  return profile.displayName.trim();
}
