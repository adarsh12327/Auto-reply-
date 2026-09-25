import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  status: { type: String, enum: ['open', 'pending', 'closed'], default: 'open' },
  subject: { type: String, default: '' },
  lastMessageAt: { type: Date, default: Date.now }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  senderId: { type: Number, required: true },
  senderRole: { type: String, enum: ['user', 'support', 'admin'], required: true },
  text: { type: String, required: true, maxlength: 4096 }
}, { timestamps: true });

export const SupportTicket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', ticketSchema);
export const SupportMessage = mongoose.models.SupportMessage || mongoose.model('SupportMessage', messageSchema);
