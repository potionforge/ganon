/** Marker passed through FirestoreManager; FirestoreAdapter maps it to `FieldValue.delete()`. */
export const GANON_FIELD_DELETE = Symbol.for('ganon.firestore.fieldDelete');

export function createFieldDeleteMarker(): typeof GANON_FIELD_DELETE {
  return GANON_FIELD_DELETE;
}

export function isFieldDeleteMarker(value: unknown): value is typeof GANON_FIELD_DELETE {
  return value === GANON_FIELD_DELETE;
}
