
import type { UserProfile } from '@/types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar'; // AvatarImage removed as next/image is used directly
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { User } from 'lucide-react';
import Image from 'next/image';

interface UserProfileCardProps {
  user: UserProfile | null; // Allow null for loading states or if no user
}

export function UserProfileCard({ user }: UserProfileCardProps) {
  if (!user) {
    // Optional: Render a skeleton or placeholder if user is null
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

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="items-center text-center">
        <Avatar className="w-24 h-24 mb-4 border-2 border-primary">
          {/* Use next/image for optimized image loading */}
          <Image 
            src={user.photoUrl || `https://placehold.co/96x96.png?text=${user.name?.charAt(0) || 'A'}`} 
            alt={user.name || 'User avatar'}
            width={96} 
            height={96} 
            className="rounded-full object-cover" 
            data-ai-hint={user.dataAiHint || "person"}
            onError={(e) => { // Fallback for broken images
              const target = e.target as HTMLImageElement;
              target.onerror = null; // prevent infinite loop
              target.src = `https://placehold.co/96x96.png?text=${user.name?.charAt(0) || 'A'}`;
            }}
          />
          <AvatarFallback>
            {user.name ? user.name.charAt(0).toUpperCase() : <User className="w-12 h-12 text-muted-foreground" />}
          </AvatarFallback>
        </Avatar>
        <CardTitle className="text-2xl">{user.name || "Anonymous User"}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-center text-foreground/80 text-base leading-relaxed whitespace-pre-wrap">
          {user.bio || "No bio available."}
        </CardDescription>
      </CardContent>
    </Card>
  );
}
