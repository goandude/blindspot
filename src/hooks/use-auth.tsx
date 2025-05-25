
"use client";

import { useState, useEffect, useCallback } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  signOut as firebaseSignOut,
  type User as FirebaseUser 
} from 'firebase/auth';
import { ref, get, set, serverTimestamp, update } from 'firebase/database';
import { auth, googleProvider, db } from '@/lib/firebase';
import type { UserProfile } from '@/types';
import { useToast } from '@/hooks/use-toast';

interface AuthState {
  user: FirebaseUser | null;
  profile: UserProfile | null;
  loading: boolean;
  error: Error | null;
}

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    profile: null,
    loading: true,
    error: null,
  });
  const { toast } = useToast();

  const fetchUserProfile = useCallback(async (firebaseUser: FirebaseUser): Promise<UserProfile | null> => {
    const userRef = ref(db, `users/${firebaseUser.uid}`);
    const snapshot = await get(userRef);

    if (snapshot.exists()) {
      return snapshot.val() as UserProfile;
    } else {
      // Create a new profile if it doesn't exist
      const newUserProfile: UserProfile = {
        id: firebaseUser.uid,
        name: firebaseUser.displayName || 'Anonymous User',
        email: firebaseUser.email || '',
        photoUrl: firebaseUser.photoURL || `https://placehold.co/300x300.png?text=${(firebaseUser.displayName || 'A').charAt(0)}`,
        dataAiHint: firebaseUser.photoURL ? 'person' : undefined,
        bio: 'New user, excited to connect!', // Default bio
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp(),
      };
      await set(userRef, newUserProfile);
      return newUserProfile;
    }
  }, []);
  
  const updateUserProfile = useCallback(async (uid: string, updates: Partial<UserProfile>) => {
    const userRef = ref(db, `users/${uid}`);
    try {
      await update(userRef, {...updates, updatedAt: serverTimestamp()});
      setAuthState(prev => prev.profile && prev.user?.uid === uid ? { ...prev, profile: { ...prev.profile, ...updates } } : prev);
      toast({ title: "Profile Updated", description: "Your profile has been successfully updated." });
    } catch (error) {
      console.error("Error updating profile:", error);
      toast({ title: "Update Error", description: "Could not update your profile.", variant: "destructive" });
    }
  }, [toast]);


  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setAuthState(prev => ({ ...prev, user: firebaseUser, loading: true, error: null }));
        try {
          const profile = await fetchUserProfile(firebaseUser);
          // Update last login timestamp
          const userRef = ref(db, `users/${firebaseUser.uid}`);
          await update(userRef, { lastLogin: serverTimestamp() });
          
          setAuthState({ user: firebaseUser, profile, loading: false, error: null });
        } catch (err) {
          console.error("Error fetching/creating user profile:", err);
          setAuthState({ user: firebaseUser, profile: null, loading: false, error: err as Error });
          toast({ title: "Profile Error", description: "Could not load your profile.", variant: "destructive" });
        }
      } else {
        setAuthState({ user: null, profile: null, loading: false, error: null });
      }
    });

    return () => unsubscribe();
  }, [fetchUserProfile, toast]);

  const signInWithGoogle = async () => {
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      await signInWithPopup(auth, googleProvider);
      // onAuthStateChanged will handle setting user and profile
    } catch (error) {
      console.error("Google Sign-In Error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error: error as Error }));
      toast({ title: "Sign-In Error", description: "Could not sign in with Google.", variant: "destructive" });
    }
  };

  const signOut = async () => {
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      await firebaseSignOut(auth);
      // onAuthStateChanged will handle setting user and profile to null
    } catch (error) {
      console.error("Sign-Out Error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error: error as Error }));
      toast({ title: "Sign-Out Error", description: "Could not sign out.", variant: "destructive" });
    }
  };

  return { ...authState, signInWithGoogle, signOut, updateUserProfile };
}
