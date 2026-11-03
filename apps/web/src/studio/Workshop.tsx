/**
 * Le panneau « Atelier » d'avant la refonte (ADR-113) vit maintenant dans la boîte « À vous » (studio/projet/Inbox.tsx) :
 * les décisions en cartes, « En cours » et « Récemment fusionné » dessous. Reste ici le format des coûts, partagé.
 */
export const money = (usd: number) => `${usd.toFixed(2).replace(".", ",")} $`;
