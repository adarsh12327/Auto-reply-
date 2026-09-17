import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  telegramId:{type:String,unique:true,index:true}, username:String, firstName:String,
  referrerId:String, referrals:{type:Number,default:0}, referralEarned:{type:Number,default:0},
  subscribed:{type:Boolean,default:false}, createdAt:{type:Date,default:Date.now}
});

const AccountSchema = new mongoose.Schema({
  ownerId:{type:String,index:true}, phone:String, session:String, autoReply:{type:Boolean,default:false},
  replyText:{type:String,default:''}, connectedAt:{type:Date,default:Date.now}
});

const SettingSchema = new mongoose.Schema({ key:{type:String,unique:true}, value:mongoose.Schema.Types.Mixed });

export const User=mongoose.model('User',UserSchema);
export const Account=mongoose.model('Account',AccountSchema);
export const Setting=mongoose.model('Setting',SettingSchema);

export async function connectDb(){
  if(!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');
}

export async function setting(key, fallback=null){
  const row=await Setting.findOne({key}).lean();
  return row ? row.value : fallback;
}
export async function setSetting(key,value){ return Setting.findOneAndUpdate({key},{value},{upsert:true,new:true}); }
