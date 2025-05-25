
import type { UserProfile, OnlineUser } from '@/types'; // Added OnlineUser
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { User } from 'lucide-react';
// Removed next/image as photoUrl is now simpler string

interface UserProfileCardProps {
  user: UserProfile | OnlineUser | null; // Allow OnlineUser as well for simpler display
  isSessionUser?: boolean; // To distinguish the current session user card
}

export function UserProfileCard({ user, isSessionUser = false }: UserProfileCardProps) {
  if (!user) {
    return (
      <Card className="w-full max-w-md shadow-lg animate-pulse">
        <CardHeader className="items-center text-center">
          <div className="w-24 h-24 mb-4 rounded-full bg-muted"></div>
          <div className="h-6 w-3/4 bg-muted rounded"></div>
        </CardHeader>
        <CardContent>
          <div className="h-4 w-full bg-muted rounded mb-2"></div>
          <div className="h-4 w-5/6 bg-muted rounded"></div>
        </CardContent>
      </Card>
    );
  }

  const photo = user.photoUrl || `https://placehold.co/96x96.png?text=${user.name?.charAt(0) || 'A'}`;
  const bio = (user as UserProfile).bio; // Attempt to get bio if UserProfile

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="items-center text-center">
        <Avatar className="w-24 h-24 mb-4 border-2 border-primary">
          <AvatarImage 
            src={photo} 
            alt={user.name || 'User avatar'} 
            data-ai-hint={(user as UserProfile).dataAiHint || "avatar abstract"}
          />
          <AvatarFallback>
            {user.name ? user.name.charAt(0).toUpperCase() : <User className="w-12 h-12 text-muted-foreground" />}
          </AvatarFallback>
        </Avatar>
        <CardTitle className="text-2xl">{user.name || "Anonymous User"}</CardTitle>
        {isSessionUser && <CardDescription className="text-sm">Session ID: {user.id}</CardDescription>}
      </CardHeader>
      {bio && (
        <CardContent>
          <CardDescription className="text-center text-foreground/80 text-base leading-relaxed whitespace-pre-wrap">
            {bio}
          </CardDescription>
        </CardContent>
      )}
       {!bio && !isSessionUser && (
        <CardContent>
            <CardDescription className="text-center text-foreground/80 text-base">
                ID: {user.id}
            </CardDescription>
        </CardContent>
      )}
    </Card>
  );
}

    