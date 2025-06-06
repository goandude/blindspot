
"use client";

import { Button } from '@/components/ui/button';
// Standard Dialog components are imported from '@/components/ui/dialog'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { IncomingCallOffer } from '@/types';
import { Phone, PhoneOff, User, X } from 'lucide-react'; // X is imported for the custom close button
import { cn } from "@/lib/utils";
import React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog"; // Import DialogPrimitive for custom content

// CustomDialogContent definition using DialogPrimitive to manage the close button visibility
const CustomDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideCloseButton?: boolean }
>(({ className, children, hideCloseButton, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children}
      {!hideCloseButton && ( // Logic to optionally render the close button
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
CustomDialogContent.displayName = "CustomDialogContent";

interface IncomingCallDialogProps {
  isOpen: boolean;
  offer: IncomingCallOffer | null;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingCallDialog({ isOpen, offer, onAccept, onDecline }: IncomingCallDialogProps) {
  if (!offer) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onDecline(); /* Decline if closed by other means */ }}>
      <CustomDialogContent className="sm:max-w-[425px]" onInteractOutside={(e) => e.preventDefault()} hideCloseButton>
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-2xl">Incoming Call</DialogTitle>
           <Avatar className="w-24 h-24 my-4 border-2 border-primary shadow-md">
            <AvatarImage src={offer.callerPhotoUrl} alt={offer.callerName} data-ai-hint="avatar abstract" />
            <AvatarFallback>{offer.callerName ? offer.callerName.charAt(0).toUpperCase() : <User />}</AvatarFallback>
          </Avatar>
          <DialogDescription className="text-lg">
            <span className="font-semibold">{offer.callerName || 'Unknown Caller'}</span>
            {offer.callerCountryCode && ` (${offer.callerCountryCode})`}
            {offer.callerIsGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
            {' '}is calling you.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-center gap-4 sm:justify-center pt-4">
          <Button onClick={onDecline} variant="destructive" size="lg" className="flex-1 sm:flex-none sm:px-8">
            <PhoneOff className="mr-2 h-5 w-5" />
            Decline
          </Button>
          <Button onClick={onAccept} variant="default" size="lg" className="flex-1 sm:flex-none sm:px-8 bg-green-600 hover:bg-green-700">
            <Phone className="mr-2 h-5 w-5" />
            Accept
          </Button>
        </DialogFooter>
      </CustomDialogContent>
    </Dialog>
  );
}
