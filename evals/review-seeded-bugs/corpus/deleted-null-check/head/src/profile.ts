export type Profile = { displayName?: string | null };

export function displayName(profile: Profile | null): string {
  return profile!.displayName!.trim();
}
