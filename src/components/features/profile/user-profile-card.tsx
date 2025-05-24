import type { UserProfile } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { User } from 'lucide-react';
import Image from 'next/image';

interface UserProfileCardProps {
  user: UserProfile;
}

export function UserProfileCard({ user }: UserProfileCardProps) {
  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="items-center text-center">
        <Avatar className="w-24 h-24 mb-4 border-2 border-primary">
          <Image 
            src={user.photoUrl} 
            alt={user.name} 
            width={96} 
            height={96} 
            className="rounded-full object-cover" 
            data-ai-hint={user.dataAiHint || "person"}
          />
          <AvatarFallback>
            <User className="w-12 h-12 text-muted-foreground" />
          </AvatarFallback>
        </Avatar>
        <CardTitle className="text-2xl">{user.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-center text-foreground/80 text-base leading-relaxed">
          {user.bio}
        </CardDescription>
      </CardContent>
    </Card>
  );
}
