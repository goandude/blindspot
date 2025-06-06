
"use client";

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser } from '@/types';
import { db } from '@/lib/firebase';
import { ref, onValue, off, remove, type DatabaseReference } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { User, AlertTriangle, Trash2, Users as UsersIcon } from 'lucide-react'; // Renamed Users to UsersIcon to avoid conflict
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function AdminPage() {
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const onlineUsersRef = useRef<DatabaseReference | null>(null);
  const onlineUsersCallback = useRef<((snapshot: any) => void) | null>(null);

  useEffect(() => {
    setLoading(true);
    onlineUsersRef.current = ref(db, 'onlineUsers');
    
    onlineUsersCallback.current = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = [];
      if (usersData) {
        for (const key in usersData) {
          if (usersData[key] && typeof usersData[key].id === 'string') {
            userList.push(usersData[key] as OnlineUser);
          }
        }
      }
      setOnlineUsers(userList.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))); // Sort by timestamp
      setLoading(false);
    };

    onValue(onlineUsersRef.current, onlineUsersCallback.current, (error) => {
      console.error("Error fetching online users:", error);
      toast({ title: "Error", description: "Could not fetch online users.", variant: "destructive" });
      setLoading(false);
    });

    return () => {
      if (onlineUsersRef.current && onlineUsersCallback.current) {
        off(onlineUsersRef.current, 'value', onlineUsersCallback.current);
      }
    };
  }, [toast]);

  const handleSelectUser = (userId: string, isSelected: boolean) => {
    setSelectedUserIds(prevSelected =>
      isSelected ? [...prevSelected, userId] : prevSelected.filter(id => id !== userId)
    );
  };

  const handleSelectAll = (isSelected: boolean | 'indeterminate') => {
    if (isSelected === true) {
      setSelectedUserIds(onlineUsers.map(user => user.id));
    } else {
      setSelectedUserIds([]);
    }
  };

  const isAllSelected = onlineUsers.length > 0 && selectedUserIds.length === onlineUsers.length;
  const isIndeterminate = selectedUserIds.length > 0 && selectedUserIds.length < onlineUsers.length;


  const handleRemoveSelectedUsers = async () => {
    if (selectedUserIds.length === 0) {
      toast({ title: "No Users Selected", description: "Please select users to remove.", variant: "default" });
      return;
    }
    try {
      for (const userId of selectedUserIds) {
        await remove(ref(db, `onlineUsers/${userId}`));
      }
      toast({ title: "Success", description: `${selectedUserIds.length} user(s) removed.` });
      setSelectedUserIds([]); 
    } catch (error: any) {
      console.error("Error removing selected users:", error);
      toast({ title: "Error", description: `Could not remove users: ${error.message}`, variant: "destructive" });
    }
  };

  const handleRemoveAllUsers = async () => {
    try {
      await remove(ref(db, 'onlineUsers'));
      toast({ title: "Success", description: "All online users cleared." });
      setSelectedUserIds([]); 
    } catch (error: any) {
      console.error("Error removing all users:", error);
      toast({ title: "Error", description: `Could not clear all users: ${error.message}`, variant: "destructive" });
    }
  };

  return (
    <MainLayout>
      <div className="w-full max-w-4xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <UsersIcon className="h-6 w-6 text-primary" /> Admin Panel - Online Users Management
            </CardTitle>
            <CardDescription>
              View and manage currently online users. This list updates in real-time.
            </CardDescription>
             <div className="mt-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
              <p className="text-sm">
                <strong>Security Notice:</strong> This is a prototype admin page. In a real application,
                access to this page MUST be strictly protected by robust admin authentication and authorization mechanisms.
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row justify-between items-center mb-6 gap-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="select-all"
                  checked={isAllSelected || isIndeterminate}
                  data-state={isIndeterminate ? 'indeterminate' : (isAllSelected ? 'checked' : 'unchecked')}
                  onCheckedChange={(checked) => handleSelectAll(checked === 'indeterminate' ? false : Boolean(checked))}
                  aria-label="Select all users"
                />
                <label
                  htmlFor="select-all"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Select All ({selectedUserIds.length} / {onlineUsers.length} selected)
                </label>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" disabled={selectedUserIds.length === 0} className="w-full sm:w-auto border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive">
                      <Trash2 className="mr-2 h-4 w-4" /> Remove Selected ({selectedUserIds.length})
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action will remove {selectedUserIds.length} selected user(s) from the online list.
                        They will need to rejoin or become active again to reappear. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleRemoveSelectedUsers} className="bg-destructive hover:bg-destructive/90">
                        Confirm Removal
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                     <Button variant="destructive" disabled={onlineUsers.length === 0} className="w-full sm:w-auto">
                        <UsersIcon className="mr-2 h-4 w-4" /> Remove All Users ({onlineUsers.length})
                      </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action will remove ALL ({onlineUsers.length}) users from the online list.
                        They will need to rejoin or become active again to reappear. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleRemoveAllUsers} className="bg-destructive hover:bg-destructive/90">
                        Confirm Remove All
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            {loading ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">Loading online users...</p>
              </div>
            ) : onlineUsers.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground">No users are currently online.</p>
              </div>
            ) : (
              <ScrollArea className="h-[500px] border rounded-md">
                <div className="p-1 sm:p-4">
                  {onlineUsers.map((user) => (
                    <div 
                      key={user.id} 
                      className={`flex items-center justify-between p-3 rounded-lg shadow-sm transition-colors mb-2
                                  ${selectedUserIds.includes(user.id) ? 'bg-primary/10 border border-primary/50' : 'bg-card hover:bg-muted/50'}`}
                      onClick={() => handleSelectUser(user.id, !selectedUserIds.includes(user.id))}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') handleSelectUser(user.id, !selectedUserIds.includes(user.id)); }}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Checkbox
                          id={`user-${user.id}`}
                          checked={selectedUserIds.includes(user.id)}
                          onCheckedChange={(checked) => handleSelectUser(user.id, Boolean(checked))}
                          aria-label={`Select user ${user.name}`}
                          onClick={(e) => e.stopPropagation()} // Prevent row click from toggling checkbox twice
                        />
                        <Avatar className="h-10 w-10 border">
                          <AvatarImage src={user.photoUrl} alt={user.name} data-ai-hint={user.dataAiHint || "avatar abstract"} />
                          <AvatarFallback>{user.name ? user.name.charAt(0).toUpperCase() : <User />}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate" title={user.name}>
                            {user.name}
                            {user.isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground truncate" title={user.id}>ID: {user.id.substring(0,12)}...</p>
                          {user.countryCode && <p className="text-xs text-muted-foreground">Country: {user.countryCode}</p>}
                        </div>
                      </div>
                       <span className="text-xs text-muted-foreground ml-4 shrink-0">
                         {user.timestamp ? `Online: ${new Date(user.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Timestamp N/A'}
                       </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}

    