import { FirebaseFirestoreTypes } from "@react-native-firebase/firestore";
import DocumentOrCollection from "./DocumentOrCollection";

type GetRefForKeyResult = {
  ref: FirebaseFirestoreTypes.DocumentReference | FirebaseFirestoreTypes.CollectionReference;
  type: DocumentOrCollection;
}

export default GetRefForKeyResult;
