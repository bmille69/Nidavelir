/**
 * Réservoir d'agents (audit du 28/10) : au plus N développeurs et testeurs au travail en même temps, tous jeux confondus.
 * Une place n'est tenue que pendant que Claude Code tourne ; elle est rendue avant la suite (vérifications du hub, testeur),
 * pour qu'un développeur qui attend son testeur ne bloque jamais la place de ce dernier.
 */
export class AgentPool {
  #busy = 0;
  readonly #queue: { grant: () => void; signal?: AbortSignal; onAbort: () => void }[] = [];
  readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max) || 1);
  }

  get busy(): number {
    return this.#busy;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** Une place est-elle libre tout de suite ? */
  get free(): boolean {
    return this.#busy < this.max;
  }

  /** Attend une place ; rend la fonction qui la libère. Refuse si le passage est arrêté pendant l'attente. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Exécution arrêtée"));
    const release = (): void => {
      const next = this.#queue.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.grant();
      } else this.#busy--;
    };
    const once = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        release();
      };
    };
    if (this.#busy < this.max) {
      this.#busy++;
      return Promise.resolve(once());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => resolve(once()),
        signal,
        onAbort: () => {
          const i = this.#queue.indexOf(entry);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(new Error("Exécution arrêtée"));
        },
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }
}
