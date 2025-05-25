
export interface UserProfile {
  id: string; // Firebase Auth UID
  name: string;
  email?: string; // Optional, from Google Auth
  photoUrl: string;
  bio: string;
  dataAiHint?: string;
  createdAt?:any; // Using 'any' for Firebase ServerValue.TIMESTAMP compatibility
  lastLogin?: any;
  updatedAt?: any;
}

// Simplified user representation for online list
export interface OnlineUser {
  id: string;
  name: string;
  photoUrl: string;
}


export interface RTCSessionDescriptionJSON {
  sdp: string;
  type: RTCSdpType;
}

export interface RTCIceCandidateJSON {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface IncomingCallOffer {
  roomId: string;
  offer: RTCSessionDescriptionInit;
  callerId: string;
  callerName: string;
  callerPhotoUrl: string;
}

export interface CallAnswer {
  answer: RTCSessionDescriptionInit;
  calleeId: string;
}
