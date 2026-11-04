/** The stable key used to join one user intent across delivery attempts and replay. */
export const messageAlias = (deliveryId: string) => `delivery:${deliveryId}`;
