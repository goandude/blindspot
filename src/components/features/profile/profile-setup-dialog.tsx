
"use client";

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { UserProfile } from "@/types";
import { ProfileForm, type ProfileFormData } from "./profile-form";
import type { User } from 'firebase/auth';
import { useToast } from '@/hooks/use-toast';

interface ProfileSetupDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void; // To allow closing from parent if needed (e.g., on sign out)
  user: Pick<User, 'uid' | 'displayName' | 'email'> & { photoUrl?: string }; // Basic info from Firebase Auth
  onSave: (profileData: UserProfile) => Promise<void>; // Function to save the full profile
  isEditing?: boolean; // To reuse for editing an existing profile
  existingProfile?: UserProfile | null; // Pass existing profile data when editing
}

export function ProfileSetupDialog({ 
  isOpen, 
  onOpenChange, 
  user, 
  onSave, 
  isEditing = false, 
  existingProfile 
}: ProfileSetupDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleFormSubmit = async (formData: ProfileFormData) => {
    setIsLoading(true);
    try {
      const profileToSave: UserProfile = {
        id: user.uid,
        name: formData.name,
        email: user.email || undefined, // Email from auth, might be null
        photoUrl: existingProfile?.photoUrl || user.photoUrl || `https://placehold.co/96x96.png?text=${formData.name.charAt(0).toUpperCase()}`, // Prioritize existing, then Google, then placeholder
        countryCode: existingProfile?.countryCode || "XX", // Preserve existing or default
        birthdate: formData.birthdate.toISOString(), // Store as ISO string
        sex: formData.sex,
        sexualOrientation: formData.sexualOrientation,
        createdAt: existingProfile?.createdAt || new Date().toISOString(), // Preserve or set new
        lastLogin: new Date().toISOString(),
        bio: existingProfile?.bio || "" // Preserve existing bio or set empty
      };
      await onSave(profileToSave);
      toast({ title: isEditing ? "Profile Updated" : "Profile Created", description: "Your information has been saved." });
      if (!isEditing) { // Only close dialog automatically if it's initial setup
        onOpenChange(false); 
      }
    } catch (error: any) {
      console.error("Error saving profile:", error);
      toast({ title: "Error", description: `Failed to save profile: ${error.message}`, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  // Prepare default values for the form, especially for editing
  const formDefaultValues: Partial<UserProfile> = isEditing && existingProfile 
    ? {
        name: existingProfile.name,
        birthdate: existingProfile.birthdate, // Will be converted to Date object in ProfileForm
        sex: existingProfile.sex,
        sexualOrientation: existingProfile.sexualOrientation,
      } 
    : {
        name: user.displayName || "",
        // birthdate, sex, sexualOrientation will be empty for new profiles
      };


  return (
    <Dialog open={isOpen} onOpenChange={isEditing ? onOpenChange : () => { /* Prevent closing by clicking outside for initial setup */ }}>
      <DialogContent className="sm:max-w-[480px]" onInteractOutside={(e) => { if (!isEditing) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Your Profile" : "Complete Your Profile"}</DialogTitle>
          <DialogDescription>
            {isEditing 
              ? "Update your profile information below." 
              : "Welcome! Please complete your profile to start connecting."}
          </DialogDescription>
        </DialogHeader>
        
        <ProfileForm 
          onSubmit={handleFormSubmit} 
          defaultValues={formDefaultValues} 
          isLoading={isLoading}
        />
        
        {isEditing && (
           <DialogFooter className="mt-4">
             <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
           </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
