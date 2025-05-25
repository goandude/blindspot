
"use client";

import { useState, useEffect, useCallback } from 'react';
import { 
  onAuthStateChanged,
  signOut as firebaseSignOut,
  signInWithRedirect, // Or signInWithPopup
  GoogleAuthProvider,
  type User as FirebaseUser 
} from 'firebase/auth';
import { ref, get, set, serverTimestamp, update, onDisconnect, goOffline, goOnline } from 'firebase/database';
import { auth, db, googleProvider } from '@/lib/firebase';
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
      // Update local authState.profile with the new updates
      setAuthState(prev => {
        if (prev.profile && prev.user?.uid === uid) {
          const updatedProfile = { ...prev.profile, ...updates };
          return { ...prev, profile: updatedProfile };
        }
        return prev;
      });
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
          goOnline(db); // Ensure Firebase connection is active
          const profile = await fetchUserProfile(firebaseUser);
          const userRef = ref(db, `users/${firebaseUser.uid}`);
          await update(userRef, { lastLogin: serverTimestamp() });
          
          setAuthState({ user: firebaseUser, profile, loading: false, error: null });

        } catch (err) {
          console.error("Error fetching/creating user profile:", err);
          setAuthState({ user: firebaseUser, profile: null, loading: false, error: err as Error });
          toast({ title: "Profile Error", description: "Could not load your profile.", variant: "destructive" });
        }
      } else {
        if (authState.user) { // If there was a user, now they are signed out
            const userStatusDatabaseRef = ref(db, `/onlineUsers/${authState.user.uid}`);
            remove(userStatusDatabaseRef); // Attempt to remove from online list on explicit sign out
            goOffline(db); // Disconnect from Firebase RTDB
        }
        setAuthState({ user: null, profile: null, loading: false, error: null });
      }
    });

    return () => unsubscribe();
  }, [fetchUserProfile, toast, authState.user]); // Added authState.user to dependencies for cleanup logic

  const signInWithGoogle = async () => {
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      await signInWithRedirect(auth, googleProvider);
      // onAuthStateChanged will handle the result
    } catch (error) {
      console.error("Google Sign-In Error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error: error as Error }));
      toast({ title: "Sign-In Error", description: "Could not sign in with Google.", variant: "destructive" });
    }
  };

  const signOut = async () => {
    const currentUserId = authState.user?.uid;
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      if (currentUserId) {
        // Before signing out, remove user from onlineUsers
        const userStatusDatabaseRef = ref(db, `/onlineUsers/${currentUserId}`);
        await remove(userStatusDatabaseRef);
      }
      await firebaseSignOut(auth);
      // onAuthStateChanged will set user and profile to null.
      // It will also call goOffline(db).
    } catch (error) {
      console.error("Sign-Out Error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error: error as Error }));
      toast({ title: "Sign-Out Error", description: "Could not sign out.", variant: "destructive" });
    }
  };

  // Effect to handle browser close or refresh for presence
  useEffect(() => {
    if (!authState.user || !authState.profile) return;

    const userStatusDatabaseRef = ref(db, `/onlineUsers/${authState.user.uid}`);
    const presenceData = {
      id: authState.user.uid,
      name: authState.profile.name,
      photoUrl: authState.profile.photoUrl,
    };

    const connectedRef = ref(db, '.info/connected');
    const conStateListener = onValue(connectedRef, async (snapshot) => {
      if (snapshot.val() === true) {
        await set(userStatusDatabaseRef, presenceData);
        onDisconnect(userStatusDatabaseRef).remove();
      }
    });

    return () => {
      conStateListener(); // Detach listener
      // onDisconnect handles removal if connection drops, but if user signs out, explicit removal is better
    };
  }, [authState.user, authState.profile]);


  return { ...authState, signInWithGoogle, signOut, updateUserProfile };
}
