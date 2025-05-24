import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Video, Mic, MicOff, VideoOff, PhoneOff } from 'lucide-react';
import Image from 'next/image';

export function VideoChatPlaceholder() {
  return (
    <Card className="w-full shadow-xl overflow-hidden">
      <CardHeader className="bg-muted/50 p-4">
        <CardTitle className="text-lg text-center text-foreground/90">Anonymous Video Call</CardTitle>
      </CardHeader>
      <CardContent className="p-0 aspect-video bg-secondary/30 flex flex-col items-center justify-center">
        <div className="relative w-full h-full flex items-center justify-center">
          <Image 
            src="https://placehold.co/600x400.png" 
            alt="Video chat placeholder" 
            layout="fill" 
            objectFit="cover"
            data-ai-hint="abstract video call"
            className="opacity-30"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30">
            <Video className="w-24 h-24 text-primary-foreground/70 mb-4" />
            <p className="text-primary-foreground/90 text-xl font-medium">Connecting anonymously...</p>
            <p className="text-primary-foreground/70">Your identity is hidden during this call.</p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-center gap-3 p-4 bg-muted/50">
        <Button variant="outline" size="icon" aria-label="Toggle Microphone">
          <Mic className="w-5 h-5" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Toggle Camera">
          <VideoOff className="w-5 h-5" />
        </Button>
        <Button variant="destructive" size="icon" aria-label="End Call">
          <PhoneOff className="w-5 h-5" />
        </Button>
      </CardFooter>
    </Card>
  );
}
