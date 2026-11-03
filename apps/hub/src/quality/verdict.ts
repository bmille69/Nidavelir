import type { VerificationOutput } from "@studio/contracts";

type Check = VerificationOutput["checks"][number];

/**
 * « Validé avec remarques » ne suffit plus quand la remarque touche ce qu'on voit ou ce qu'a demandé le directeur créatif
 * (ADR-124) : à la place de son œil, un point de rendu ou de sa demande qui n'est pas prouvé bloque la fusion.
 */
export const isBlockingCheck = (c: Check): boolean => c.result !== "pass" && (c.kind === "rendu" || c.source === "demande");

export const blockingChecks = (v: Pick<VerificationOutput, "checks">): Check[] => v.checks.filter(isBlockingCheck);

/** Le chantier ne peut pas être tenu pour validé : le testeur a échoué, ou un point bloquant reste. */
export const verdictBlocks = (v: Pick<VerificationOutput, "verdict" | "checks">): boolean => v.verdict === "fail" || blockingChecks(v).length > 0;

/** Le verdict tel que le hub le retient, pour ce qui dit « validé » ou « refusé ». */
export const effectiveVerdict = (v: Pick<VerificationOutput, "verdict" | "checks">): VerificationOutput["verdict"] => (verdictBlocks(v) ? "fail" : v.verdict);

/** Ce que le développeur doit reprendre : les échecs, et les points bloquants pas encore prouvés. */
export const pointsToFix = (v: Pick<VerificationOutput, "checks">): Check[] => v.checks.filter((c) => c.result === "fail" || isBlockingCheck(c));

/** Un point à reprendre, en une ligne. */
export const describePoint = (c: Check): string =>
  `${c.criterion} : ${c.evidence}${c.result === "not_verifiable" ? " (non prouvé : à prouver par une pose de contrôle ou un test qui mesure le défaut)" : ""}`;
