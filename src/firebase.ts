import { initializeApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  Auth,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  Firestore,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAIMe-Az44DkEy9D645Oed9MzWrfHwnehk",
  authDomain: "tea-6ddcb.firebaseapp.com",
  projectId: "tea-6ddcb",
  storageBucket: "tea-6ddcb.firebasestorage.app",
  messagingSenderId: "341463323384",
  appId: "1:341463323384:web:b2b018411f31f8847d610d"
};

const app: FirebaseApp = initializeApp(firebaseConfig);
export const auth: Auth = getAuth(app);
export const firestore: Firestore = getFirestore(app);

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User | null> {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error('Google sign-in failed:', error);
    return null;
  }
}

export async function signOut(): Promise<void> {
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    console.error('Sign-out failed:', error);
  }
}

export function onAuthChanged(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export function getCurrentUser(): User | null {
  return auth.currentUser;
}
