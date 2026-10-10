import { ref } from 'vue';

const KEY = 'blockcraft.backgroundJob';
function initialJobId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Job IDs remain available in the app header after dismissing a progress modal. */
export const backgroundJobId = ref<string | null>(initialJobId());

export function setBackgroundJob(id: string | null): void {
  backgroundJobId.value = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // The current page can still show the job if browser storage is disabled.
  }
}
