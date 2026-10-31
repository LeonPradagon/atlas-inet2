import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

export function SubmitSurveyButton({historyId,rowNumber=0}:{historyId:string;rowNumber?:number}) {
  const client=useQueryClient()
  const submit=useMutation({mutationFn:()=>api('/surveys',{method:'POST',data:{historyId,rowNumber}}),onSuccess:()=>client.invalidateQueries({queryKey:['surveys']})})
  return <div className="my-3"><button className="btn btn-outline-primary" disabled={submit.isPending||submit.isSuccess} onClick={()=>submit.mutate()}>{submit.isSuccess?'Survei sudah diajukan':submit.isPending?'Mengajukan...':'Ajukan survei'}</button>{submit.isSuccess&&<small role="status" className="d-block text-success mt-1">Tersimpan di menu Survei & Verifikasi.</small>}{submit.error&&<small role="alert" className="d-block text-danger mt-1">{submit.error.message}</small>}</div>
}
